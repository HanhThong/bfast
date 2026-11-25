// esbuild turns a CSS import into a sibling stylesheet; tsc just needs to know
// the module exists.
declare module '*.css';
