interface Env {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_API_TOKEN_MAUSBOT_SI?: string;
  LOCAL_GATEWAY_DISCONNECT?: Fetcher;
}

declare namespace Cloudflare {
  interface Env {
    CLOUDFLARE_API_TOKEN?: string;
    CLOUDFLARE_API_TOKEN_MAUSBOT_SI?: string;
    LOCAL_GATEWAY_DISCONNECT?: Fetcher;
  }
}
