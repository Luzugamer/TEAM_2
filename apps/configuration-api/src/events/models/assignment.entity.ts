export interface AssignmentEntity {
  id: string;
  organization_id: string;
  event_id: string | null;
  site_id: string | null;
  user_id: string;
  role: string;
  scopes: string[];
  valid_from: string;
  valid_to: string | null;
  is_active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

