/** An absent setting keeps existing deployments on Tofu's production broker. */
export function authBrokerOrigin(value = 'https://oauth.trytofu.ai'): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return '';
    return url.origin;
  } catch {
    return '';
  }
}
