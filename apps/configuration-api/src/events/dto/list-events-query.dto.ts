import {
  IsOptional,
  IsUUID,
  IsString,
  IsEnum,
  IsISO8601,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EventStatus } from '../models/event-status.enum';

export class ListEventsQueryDto {
  @IsOptional()
  @IsUUID()
  site_id?: string;

  @IsOptional()
  @IsString()
  kind?: string;

  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;

  @IsOptional()
  @IsISO8601()
  from_date?: string;

  @IsOptional()
  @IsISO8601()
  to_date?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  cursor?: string;
}

