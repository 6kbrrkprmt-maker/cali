import { IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  public account!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  public password!: string;
}
