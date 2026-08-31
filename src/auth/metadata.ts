// ============ OAuth 元数据端点 ============
// - RFC 9728 Protected Resource Metadata: /.well-known/oauth-protected-resource
// - RFC 8414 Authorization Server Metadata 镜像: /.well-known/oauth-authorization-server
//   （MaxKey v4.1.8 不对外发布 8414 元数据，MCP 网关按调研结论镜像一份，
//    authorization_endpoint/token_endpoint 指向 MaxKey 实测存活端点）

import { Router } from 'express';
import { ServerConfig } from '../config';

export function buildMetadataRouter(cfg: ServerConfig): Router {
  const router = Router();

  // RFC 9728：PRM 位于资源元数据根。MCP_PUBLIC_URL 是资源标识。
  const protectedResourceMetadata = {
    resource: cfg.publicUrl,
    authorization_servers: [cfg.issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: ['openid', 'oa.read'],
    resource_documentation: cfg.publicUrl + '/docs/auth',
  };

  const authorizationServerMetadata = {
    issuer: cfg.issuer,
    authorization_endpoint: cfg.authorizeUrl,
    token_endpoint: cfg.tokenUrl,
    ...(cfg.userinfoUrl ? { userinfo_endpoint: cfg.userinfoUrl } : {}),
    ...(cfg.jwksUrl ? { jwks_uri: cfg.jwksUrl } : {}),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  };

  router.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json(protectedResourceMetadata);
  });

  // RFC 8414 路径按 issuer 后缀拼：/.well-known/oauth-authorization-server{issuerPath}
  const issuerPath = (() => {
    try {
      const u = new URL(cfg.issuer);
      return u.pathname.replace(/\/+$/, '');
    } catch {
      return '';
    }
  })();
  router.get('/.well-known/oauth-authorization-server' + issuerPath, (_req, res) => {
    res.json(authorizationServerMetadata);
  });

  return router;
}

/** 401 响应统一携带的 WWW-Authenticate 头（MCP 2026-07-28 规范） */
export function wwwAuthenticateHeader(cfg: ServerConfig, error?: string): string {
  const meta = `${cfg.publicUrl}/.well-known/oauth-protected-resource`;
  const base = `Bearer resource_metadata="${meta}"`;
  return error ? `${base}, error="${error}"` : base;
}
