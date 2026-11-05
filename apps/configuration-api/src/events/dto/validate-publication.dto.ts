import { IsInt, Min } from 'class-validator';

export class ValidatePublicationDto {
  @IsInt()
  @Min(1)
  expected_event_revision!: number;
}
