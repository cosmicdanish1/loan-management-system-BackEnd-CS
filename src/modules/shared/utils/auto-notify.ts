import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

const logger = new Logger('AutoNotify');

export async function autoQueueNotification(
    dataSource: DataSource,
    memberNo: string,
    messageText: string,
    type: string = 'TRANSACTION',
): Promise<void> {
    try {
        const memberInfo = await dataSource.query(
            `SELECT TRIM(COALESCE(f_name,'') || ' ' || COALESCE(l_name,'')) as name, phoneno as phone, email
             FROM member_master WHERE mbno::text = $1 LIMIT 1`,
            [memberNo]
        );
        const phone = memberInfo[0]?.phone || '';
        const email = memberInfo[0]?.email || '';

        if (!phone && !email) {
            // Nothing to deliver to — queuing this would just sit as permanently
            // undeliverable "PENDING" clutter (confirmed live: it previously did,
            // as literal recipient 'NO_CONTACT'). Skip instead of queuing junk.
            logger.debug(`Skipped queue for ${memberNo}: no phone or email on file`);
            return;
        }

        const channel = phone ? 'SMS' : 'EMAIL';
        const recipient = phone || email;

        // Use correct column names: mbno (not memberNo), enums for channel/type/status
        await dataSource.query(`
            INSERT INTO notification_logs (
                mbno, channel, type, message, recipient, status, "createdAt"
            ) VALUES ($1::numeric, $2::notification_logs_channel_enum, $3::notification_logs_type_enum, $4, $5, 'PENDING'::notification_logs_status_enum, NOW())
        `, [memberNo, channel, type, messageText, recipient]);
    } catch (e) {
        logger.warn(`Failed to queue for ${memberNo}: ${(e as any)?.message}`);
    }
}
