import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { NotificationChannel } from '../entities/notification-log.entity';

const trim = ({ value }: { value: any }) => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : value);

/** POST /notifications/queue-manual and /send-manual (ES-360). */
export class QueueManualDto {
    @Transform(trim) @Matches(/^\d{1,12}$/, { message: 'Member number must be digits only (up to 12).' })
    memberNo: string;

    @IsEnum(NotificationChannel, { message: 'Channel must be SMS, WHATSAPP or EMAIL.' })
    channel: NotificationChannel;

    @Transform(trim) @IsString() @IsNotEmpty({ message: 'Message cannot be empty.' }) @MaxLength(5000, { message: 'Message is too long (most 5000 characters).' })
    message: string;

    /** Phone (SMS / WhatsApp) or e-mail. When left out, the member's own number / e-mail on file is used. */
    @IsOptional() @Transform(trim) @IsString() @MaxLength(100, { message: 'Recipient can be at most 100 characters.' })
    recipient?: string;
}

/** POST /notifications/queue-transaction-alert (ES-360). */
export class QueueTransactionAlertDto {
    @Transform(trim) @Matches(/^\d{1,12}$/, { message: 'Member number must be digits only (up to 12).' })
    memberNo: string;

    @Transform(trim) @IsString() @IsNotEmpty({ message: 'Transaction type is required.' }) @MaxLength(50, { message: 'Transaction type can be at most 50 characters.' })
    transactionType: string;

    @IsNumber({ allowNaN: false, allowInfinity: false }, { message: 'Amount must be a number.' })
    amount: number;

    @IsOptional() @Transform(trim) @IsString() @MaxLength(100)
    recipient?: string;

    @IsOptional() @IsEnum(NotificationChannel, { message: 'Channel must be SMS, WHATSAPP or EMAIL.' })
    channel?: NotificationChannel;

    @IsOptional() @Transform(trim) @IsString() @MaxLength(60)
    reference?: string;
}
