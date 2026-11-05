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

export class CreateEventDto {
  @IsUUID('all', { message: 'site_id must be a valid UUID' })
  site_id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must contain only lowercase alphanumeric characters and hyphens',
  })
  slug!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  kind!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  timezone!: string;

  @IsISO8601({}, { message: 'starts_at must be a valid ISO 8601 UTC date string' })
  starts_at!: string;

  @IsISO8601({}, { message: 'ends_at must be a valid ISO 8601 UTC date string' })
  ends_at!: string;

  @IsOptional()
  @IsObject()
  policy?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

