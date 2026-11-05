import {
  IsUUID,
  IsString,
  IsNotEmpty,
  IsOptional,
  IsISO8601,
  MaxLength,
  IsArray,
  ArrayNotEmpty,
} from 'class-validator';

export class CreateAssignmentDto {
  @IsUUID('all', { message: 'user_id must be a valid UUID' })
  user_id!: string;

  @IsString()
  @IsNotEmpty({ message: 'role is required' })
  @MaxLength(50)
  role!: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'At least one scope must be granted' })
  @IsString({ each: true })
  scopes!: string[];

  @IsOptional()
  @IsISO8601({}, { message: 'valid_from must be a valid ISO 8601 UTC date string' })
  valid_from?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'valid_to must be a valid ISO 8601 UTC date string' })
  valid_to?: string;

  @IsOptional()
  @IsUUID('all', { message: 'site_id must be a valid UUID' })
  site_id?: string;
}

