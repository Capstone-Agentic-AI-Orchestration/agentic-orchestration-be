import { IsString, MinLength } from 'class-validator';

export class AddTaskCommentDto {
  @IsString()
  @MinLength(1, { message: 'message must not be empty' })
  message!: string;
}
