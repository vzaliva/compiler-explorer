// Copyright (c) 2023, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import path from 'path';

import Parser from 'tree-sitter';
import coreLanguage from 'tree-sitter-core';

import { BypassCache, CacheKey, ExecutionOptions } from '../../types/compilation/compilation.interfaces.js';
import type { PreliminaryCompilerInfo } from '../../types/compiler.interfaces.js';
import { ExecutableExecutionOptions } from '../../types/execution/execution.interfaces.js';
import type { ParseFiltersAndOutputOptions } from '../../types/features/filters.interfaces.js';
import { BaseCompiler } from '../base-compiler.js';
import { CompilationEnvironment } from '../compilation-env.js';
import { logger } from '../logger.js';
import * as utils from '../utils.js';
import { AsmResultSource, ParsedAsmResultLine } from '../../types/asmresult/asmresult.interfaces.js';

type Range = {
    start: Parser.Point;
    end: Parser.Point;
};

type LocationRange = {
    location: Range;
    cursor: Range | Parser.Point | null;
};


export class CerberusCompiler extends BaseCompiler {
    static get key() {
        return 'cerberus';
    }

    constructor(compilerInfo: PreliminaryCompilerInfo, env: CompilationEnvironment) {
        super(
            {
                // Default is to disable all "cosmetic" filters
                disabledFilters: ['labels', 'directives', 'commentOnly', 'trim', 'debugCalls'],
                ...compilerInfo,
            },
            env,
        );
    }

    override getSharedLibraryPathsAsArguments() {
        return [];
    }

    override optionsForFilter(filters: ParseFiltersAndOutputOptions, outputFileName: string) {
        filters.binary = true;
        return ['-c', '-o', outputFileName];
    }

    override getOutputFilename(dirPath: string) {
        return path.join(dirPath, `${path.basename(this.compileFilename, this.lang.extensions[0])}.co`);
    }

    override async objdump(outputFilename: string, result: any, maxSize: number) {
        if (!(await utils.fileExists(outputFilename))) {
            result.asm = '<No output file ' + outputFilename + '>';
            return result;
        }

        const execOptions: ExecutionOptions = {
            maxOutput: maxSize,
            customCwd: (result.dirPath as string) || path.dirname(outputFilename),
        };

        const args = ['--pp_flags=loc', '--pp=core', outputFilename];

        const objResult = await this.exec(this.compiler.objdumper, args, execOptions);
        if (objResult.code === 0) {
            result.objdumpTime = objResult.execTime;
            result.asm = this.postProcessObjdumpOutput(objResult.stdout);
        } else {
            logger.error(`Error executing objdump ${this.compiler.objdumper}`, objResult);
            result.asm = `<No output: objdump returned ${objResult.code}>`;
        }

        return result;
    }

    override async handleInterpreting(key: CacheKey, executeParameters: ExecutableExecutionOptions) {
        const compileResult = await this.getOrBuildExecutable(key, BypassCache.None);
        if (compileResult.code === 0) {
            executeParameters.args = [
                '--exec',
                this.getOutputFilename(compileResult.dirPath),
                '--',
                ...executeParameters.args,
            ];
            const result = await this.runExecutable(this.compiler.exe, executeParameters, compileResult.dirPath);
            return {
                ...result,
                didExecute: true,
                buildResult: compileResult,
            };
        } else {
            return {
                stdout: compileResult.stdout,
                stderr: compileResult.stderr,
                code: compileResult.code,
                didExecute: false,
                buildResult: compileResult,
                timedOut: false,
            };
        }
    }

    private parse_position(node: Parser.SyntaxNode): Parser.Point | null {
        if (node.type !== 'position')
            return null;

        const filenameNode = node.childForFieldName('filename');
        if (!filenameNode || filenameNode.text !== 'example.c')
            return null;

        const rowNode = node.childForFieldName('line');
        const columnNode = node.childForFieldName('column');
        if (!rowNode || !columnNode)
            return null;

        const row = parseInt(rowNode.text, 10);
        const column = parseInt(columnNode.text, 10);
        if (isNaN(row) || isNaN(column))
            return null;

        return { row: row, column: column };
    };

    /* Attempt to parse 'location' node.
       Returns null if the node does not correspond to location range.        
     */
    private parse_location(node: Parser.SyntaxNode): LocationRange | null {
        if (node.firstNamedChild === null || node.firstNamedChild.type !== 'location_range')
            return null;

        const startNode = node.firstNamedChild.childForFieldName('start');
        const endNode = node.firstNamedChild.childForFieldName('end');
        if (!startNode || !endNode)
            return null;

        const start = this.parse_position(startNode);
        const end = this.parse_position(endNode);
        if (!start || !end)
            return null;

        const startCursorNode = node.firstNamedChild.childForFieldName('start_cursor');
        if (!startCursorNode)
            return { location: { start: start, end: end }, cursor: null };
        const start_cursor = this.parse_position(startCursorNode);
        if (!start_cursor)
            return { location: { start: start, end: end }, cursor: null };

        const endCursorNode = node.firstNamedChild.childForFieldName('end_cursor');
        if (!endCursorNode)
            return { location: { start: start, end: end }, cursor: start_cursor };
        const end_cursor = this.parse_position(endCursorNode);
        if (!end_cursor)
            return { location: { start: start, end: end }, cursor: start_cursor };
        else
            return { location: { start: start, end: end }, cursor: { start: start_cursor, end: end_cursor } };
    }

    private point_to_string(point: Parser.Point): string {
        return `${point.row}:${point.column}`;
    }

    private range_to_string(range: Range): string {
        return `${this.point_to_string(range.start)}-${this.point_to_string(range.end)}`;
    }

    private location_range_to_string(loc: LocationRange): string {
        const location = this.range_to_string(loc.location);
        if (loc.cursor === null)
            return location;
        else
            if (loc.cursor instanceof Object && 'start' in loc.cursor && 'end' in loc.cursor)
                return `${location} [${this.range_to_string(loc.cursor)}]`;
            else
                return `${location} [${this.point_to_string(loc.cursor)}]`;

    }

    private annotate_ast(node: Parser.SyntaxNode): Parser.SyntaxNode {
        var loc: LocationRange | null = null;
        for (const n of node.children) {
            if (n.type === 'location') {
                loc = this.parse_location(n);
            } else {
                if (loc !== null && n.isNamed) {
                    console.log(`Annotating ${n.type} at ${this.point_to_string(n.startPosition)}-${this.point_to_string(n.endPosition)} with location ${this.location_range_to_string(loc)}`);
                    (n as any).loc = loc;
                    loc = null;
                }
                this.annotate_ast(n);
            }
        }
        return node;
    }

    private find_all_locations(node: Parser.SyntaxNode) {
        if((node as any).loc !== undefined)
            console.log(`\tEXISTS ${node.type} at ${this.point_to_string(node.startPosition)}-${this.point_to_string(node.endPosition)} with location: ${this.location_range_to_string((node as any).loc)}`);

        for (const n of node.children) 
            this.find_all_locations(n);
    }

    private findNodesByRange(node: Parser.SyntaxNode, range: Range): Parser.SyntaxNode[] {
        const matchingNodes: Parser.SyntaxNode[] = [];

        function search(node: Parser.SyntaxNode): void {
            if (
                (node.startPosition.row < range.start.row ||
                    (node.startPosition.row === range.start.row && node.startPosition.column <= range.start.column)) &&
                (node.endPosition.row > range.end.row ||
                    (node.endPosition.row === range.end.row && node.endPosition.column >= range.end.column))
            ) {
                matchingNodes.push(node);
            }

            for (const child of node.children) {
                search(child);
            }
        }

        search(node);
        return matchingNodes.reverse();
    }

    override async processAsm(result) {
        // Handle "error" documents.
        if (!result.asm.includes('\n') && result.asm[0] === '<') {
            return [{ text: result.asm, source: null }];
        }

        const core = result.asm.replace(/\n{3,}/g, '\n\n');
        const parser = new Parser();
        parser.setLanguage(coreLanguage);

        const tree = parser.parse(core);
        const ast = this.annotate_ast(tree.rootNode);
        this.find_all_locations(ast)
        const lines = core.split('\n');
        const plines: ParsedAsmResultLine[] = lines.map((l: string, n: number) => {
            const ltrimmed = l.replace(/^\s*{-# .+ #-}\s*/, '');
            const start_col = l.length - ltrimmed.length;
            const rtrimmed = ltrimmed.trimEnd();
            const r: Range = { start: { row: n, column: start_col }, end: { row: n, column: start_col + rtrimmed.length } };
            const matchingNodes = this.findNodesByRange(ast, r);

            if(n === 28) {
                console.log(`\n\nLookng for ${this.range_to_string(r)}`);
                for(const c of matchingNodes) {
                    console.log(`\t ${c.type} at ${this.point_to_string(c.startPosition)}-${this.point_to_string(c.endPosition)} with location:`, (c as any).loc);
                }   
            }

            const coreNode = matchingNodes.find(node => (node as any).loc !== undefined);
            if (coreNode === undefined) {
                console.log(`No node with location for ${this.range_to_string(r)}`);
                return { text: l };
            } else {
                const loc: LocationRange = (coreNode as any).loc;
                console.log(`Found ${coreNode.type} at ${this.point_to_string(coreNode.startPosition)}-${this.point_to_string(coreNode.endPosition)} for ${this.range_to_string(r)} with location ${this.location_range_to_string(loc)}`);
                const src: AsmResultSource = {
                    file: null,
                    line: loc.location.start.row,
                    column: loc.location.start.column
                };
                return { text: l, source: src };
            }
        });
        return {
            asm: plines,
            languageId: 'core',
        };
    }

}
