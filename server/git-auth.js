export function githubGitAuthorizationHeader(tokenValue) {
  const token = String(tokenValue || '').trim()
  if (!token) return ''
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
}
