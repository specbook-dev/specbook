import { createContext } from 'preact'
import { useContext } from 'preact/hooks'

/** Where the open operation's API has its docs (the service's `docsUrl`), for the links its descriptions write as paths. */
export const DocsUrl = createContext<string | undefined>(undefined)

export const useDocsUrl = () => useContext(DocsUrl)
