function missing() {
  throw new Error('node-only module used in the browser');
}
export const NodeHttpHandler = missing;
export const HttpProxyAgent = missing;
export const HttpsProxyAgent = missing;
export const readFile = missing;
export const createRequire = missing;
export default missing;
