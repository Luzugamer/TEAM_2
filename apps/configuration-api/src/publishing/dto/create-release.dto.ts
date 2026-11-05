import { IsOptional, IsISO8601, IsInt, Min } from 'class-validator';

export class CreateReleaseDto {
  @IsInt()
  @Min(1)
  expected_event_revision!: number;

  @IsOptional()
  @IsISO8601({}, { message: 'effective_at must be a valid ISO 8601 UTC date string' })
  effective_at?: string;
}

