import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class StartBridgeSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  public provider?: string;

  @IsOptional()
  @IsIn(['livekit', 'frame'])
  public streamMode?: 'livekit' | 'frame';
}
