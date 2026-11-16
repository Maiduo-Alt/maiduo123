import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

@Injectable()
export class SessionEvents extends EventEmitter {}
