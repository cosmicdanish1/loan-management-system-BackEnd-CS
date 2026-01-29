# Backend Member Lookup Troubleshooting

## Current Issue
The `/api/members` and `/api/members/lookup` endpoints are returning 404, indicating the MemberModule is not loading properly.

## Check Backend Console

Look for these errors in your backend terminal:

### 1. TypeORM Entity Error
```
EntityMetadataNotFoundError: No metadata for "MemberMaster" was found
```
**Solution**: The entity might not be auto-discovered. Check `ormconfig` or database config.

### 2. Database Connection Error
```
Error: connect ECONNREFUSED
```
**Solution**: Verify database is running and connection string in `.env` is correct.

### 3. Table Not Found
```
relation "member_master" does not exist
```
**Solution**: Run database migrations or verify table exists.

### 4. Compilation Error
```
Error: Cannot find module './entities/member-master.entity'
```
**Solution**: File path or import issue.

## Steps to Debug

### Step 1: Check if Backend is Running
```bash
curl http://localhost:3000/api/auth/health
# or any other working endpoint
```

### Step 2: Check Database Connection
Verify in `backend/.env`:
```
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=your_user
DB_PASSWORD=your_password
DB_DATABASE=your_database
```

### Step 3: Verify Table Exists
Run this SQL query:
```sql
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name = 'member_master';
```

### Step 4: Check TypeORM Configuration
Look for entity auto-loading in your database config:
```typescript
entities: [__dirname + '/../**/*.entity{.ts,.js}']
// or
autoLoadEntities: true
```

### Step 5: Manual Test
Add a simple test endpoint in member.controller.ts:
```typescript
@Get('test')
async test() {
  return { message: 'Member controller is working!' };
}
```

Then test: `curl http://localhost:3000/api/members/test`

## Quick Fix: Use Existing Member Entity

If `member_master` table doesn't exist or can't be accessed, temporarily use the existing `Member` entity:

### In member.service.ts:
```typescript
async lookupMembers(search?: string): Promise<MemberLookupResponseDto[]> {
  const members = await this.memberRepository.find({
    where: { status: 'ACTIVE' },
    take: 100,
  });

  return members.map(member => ({
    memberNo: member.memberNumber,
    name: member.fullName,
    basicPay: '0',
    dateOfRetire: '',
    officeNo: '',
    address: member.address,
  }));
}
```

This will at least get the endpoint working while you debug the database issue.

## Files to Check

1. `backend/src/app.module.ts` - MemberModule imported ✓
2. `backend/src/modules/member/member.module.ts` - MemberMaster entity registered ✓
3. `backend/src/config/database.config.ts` - Entity auto-loading configuration
4. `backend/.env` - Database connection settings
5. Backend terminal - Compilation and runtime errors

## Next Steps

1. **Check backend terminal** for error messages
2. **Verify database** is running and accessible
3. **Confirm table exists**: `SELECT * FROM member_master LIMIT 1;`
4. **Restart backend** after fixing any issues
5. **Test endpoint**: `curl http://localhost:3000/api/members/lookup`

If you share the backend console output, I can provide more specific guidance!
