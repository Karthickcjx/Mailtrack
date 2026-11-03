// The spike passes jQuery straight to gmail.js and never calls it directly, so an opaque type is enough.
declare module 'jquery' {
  const jQuery: unknown;
  export default jQuery;
}
