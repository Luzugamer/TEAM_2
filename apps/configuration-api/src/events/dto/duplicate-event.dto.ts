import {
  IsUUID,
  IsString,
  IsNotEmpty,
  IsOptional,
  IsISO8601,
  Matches,
  MaxLength,
  IsObject,
} from 'class-validator';

export class DuplicateEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must contain only lowercase alphanumeric characters and hyphens',
  })
  slug!: string;

  @IsISO8601({}, { message: 'starts_at must be a valid ISO 8601 UTC date string' })
  starts_at!: string;

  @IsISO8601({}, { message: 'ends_at must be a valid ISO 8601 UTC date string' })
  ends_at!: string;

  @IsUUID('all', { message: 'site_id must be a valid UUID' })
  site_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

