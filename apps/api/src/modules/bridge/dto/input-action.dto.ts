import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class InputActionDto {
  @IsString()
  @IsIn(['click', 'key', 'scroll'])
  public type!: 'click' | 'key' | 'scroll';

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  public xRatio?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  public yRatio?: number;

  @IsOptional()
  @IsString()
  @IsIn(['left', 'right', 'middle'])
  public button?: 'left' | 'right' | 'middle';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  public clickCount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  public key?: string;

  @IsOptional()
  @IsInt()
  @Min(-3000)
  @Max(3000)
  public deltaY?: number;
}
