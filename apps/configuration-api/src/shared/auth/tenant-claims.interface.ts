export interface TenantClaims {
  sub: string; // Actor ID
  organization_id: string; // Tenant UUID
  site_id?: string;
  roles: string[];
  scopes: string[];
  request_id?: string;
  client_ip?: string;
  user_agent?: string;
}

