declare module 'tree-sitter-core/tree-sitter-core.wasm' {
    import * as TreeSitterCore from 'tree-sitter-core/bindings/node/index.d.ts';

    const wasmModule: TreeSitterCore.language;
    export default wasmModule;
}
