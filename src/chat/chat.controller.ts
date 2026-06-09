import { Body, Controller, Get, Post } from '@nestjs/common';
import { ChatService } from './chat.service';
import { AskDto } from './dto/ask.dto';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('ask')
  ask(@Body() dto: AskDto) {
    return this.chatService.ask(dto);
  }

  @Get('health')
  health() {
    return this.chatService.health();
  }
}
