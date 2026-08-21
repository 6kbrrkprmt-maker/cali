import { IsString, MaxLength } from 'class-validator';

export class PushOfferDto {
  @IsString()
  @MaxLength(200000)
  public sdp!: string;
}
