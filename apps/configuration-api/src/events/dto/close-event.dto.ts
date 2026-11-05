import { IsString, IsNotEmpty, MaxLength, IsISO8601 } from 'class-validator';

export class CloseEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;

  @IsISO8601({}, { message: 'effective_at must be a valid ISO 8601 date-time' })
  effective_at!: string;
}

