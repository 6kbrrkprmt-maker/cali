import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class PushCandidateDto {
  @IsString()
  @MaxLength(20000)
  public candidate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  public sdpMid?: string;

  @IsOptional()
  @IsInt()
  public sdpMLineIndex?: number;
}
