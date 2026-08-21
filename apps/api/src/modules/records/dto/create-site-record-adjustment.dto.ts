import { IsEnum, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { SiteRecordKind } from '@prisma/client';

export class CreateSiteRecordAdjustmentDto {
  @IsEnum(SiteRecordKind)
  public recordKind!: SiteRecordKind;

  @IsString()
  @MaxLength(128)
  public recordId!: string;

  @IsString()
  @MaxLength(300)
  public reason!: string;

  @IsObject()
  public nextValue!: Record<string, string>;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  public changeNote?: string;
}
