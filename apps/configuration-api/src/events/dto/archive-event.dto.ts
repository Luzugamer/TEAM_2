import { IsString, IsOptional, MaxLength } from 'class-validator';

export class ArchiveEventDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

