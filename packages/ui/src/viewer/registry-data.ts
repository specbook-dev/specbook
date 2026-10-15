export interface AuthProfileLike {
  title: string
  apply: { headers?: Record<string, string>; query?: Record<string, string> }
}
