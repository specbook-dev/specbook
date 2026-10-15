const NAMES: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No content',
  301: 'Moved',
  304: 'Not modified',
  400: 'Bad request',
  401: 'Unauthorized',
  402: 'Payment required',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Invalid input',
  409: 'Conflict',
  410: 'Gone',
  412: 'Precondition failed',
  422: 'Invalid input',
  429: 'Too many requests',
  500: 'Server error',
  502: 'Bad gateway',
  503: 'Unavailable',
}

export const statusName = (s: number) =>
  NAMES[s] ?? (s >= 500 ? 'Server error' : s >= 400 ? 'Client error' : 'Response')
export const statusClass = (s: number) =>
  s >= 500 ? 's5' : s >= 400 ? 's4' : s >= 300 ? 's3' : 's2'
