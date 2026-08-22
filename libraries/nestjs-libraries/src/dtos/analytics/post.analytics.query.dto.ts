import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class PostAnalyticsQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  date: number;
}
