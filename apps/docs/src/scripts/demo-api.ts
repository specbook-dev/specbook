// Every page: registers the service worker that is the demo API, and says on the page whether it is running. The terminal
// on the Test and Monitor pages is what uses it; the Run buttons answer from the spec and need no worker.
import { demoReady } from '../../demo/server/client'

document.documentElement.dataset.demo = await demoReady()
