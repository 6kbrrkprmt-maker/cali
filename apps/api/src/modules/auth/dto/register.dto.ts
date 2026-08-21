import { UserRole } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  public account!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  public password!: string;

  @IsOptional()
  @IsEnum(UserRole)
  public role?: UserRole;
}
