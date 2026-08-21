import { IsString, MaxLength } from 'class-validator';

export class PushAnswerDto {
  @IsString()
  @MaxLength(200000)
  public sdp!: string;
}
