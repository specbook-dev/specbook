// Stands in for Node modules that a browser build never calls into.
const unavailable = () => {
  throw new Error('not available in the browser')
}
export default {}
export const readFileSync = unavailable
export const promises = {}
export const resolve = (...a) => a.join('/')
export const dirname = (p) => p
export const join = (...a) => a.join('/')
export const parse = (u) => ({ protocol: '', host: '', pathname: u })
export const fileURLToPath = (u) => u
export const pathToFileURL = (u) => u
