import { IsString, IsNotEmpty, MaxLength, IsISO8601 } from 'class-validator';

export class CancelEventDto {
  @IsString()
  @IsNotEmpty({ message: 'Cancellation reason is required' })
  @MaxLength(500, { message: 'Cancellation reason cannot exceed 500 characters' })
  reason!: string;

  @IsISO8601({}, { message: 'effective_at must be a valid ISO 8601 date-time' })
  effective_at!: string;
}

