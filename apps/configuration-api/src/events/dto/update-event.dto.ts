import {
  IsString,
  IsOptional,
  IsISO8601,
  Matches,
  MaxLength,
  IsObject,
} from 'class-validator';

export class UpdateEventDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must contain only lowercase alphanumeric characters and hyphens',
  })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  kind?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'starts_at must be a valid ISO 8601 UTC date string' })
  starts_at?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'ends_at must be a valid ISO 8601 UTC date string' })
  ends_at?: string;

  @IsOptional()
  @IsObject()
  policy?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  change_summary?: string;
}

