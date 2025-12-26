async function testBalanceSheetApi() {
    const API_URL = 'http://127.0.0.1:3001/api/v1';

    try {
        console.log('Fetching all BS schedules...');
        const schedulesRes = await fetch(`${API_URL}/report/schedule?type=BS`);
        if (!schedulesRes.ok) throw new Error(`Status: ${schedulesRes.status}`);
        const resJson = await schedulesRes.json();
        const schedules = resJson.data; // TransformInterceptor wraps data
        console.log(`Found ${Array.isArray(schedules) ? schedules.length : 0} schedules`);

        if (Array.isArray(schedules) && schedules.length > 0) {
            const schedule = schedules[0];
            console.log(`Executing schedule: ${schedule.schedule_name} (ID: ${schedule.id})`);

            const payload = {
                scheduleId: schedule.id,
                fromDate: new Date().toISOString().split('T')[0],
                toDate: new Date().toISOString().split('T')[0],
                financialYearStart: `${new Date().getFullYear()}-04-01`
            };

            const executeRes = await fetch(`${API_URL}/report/schedule/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const execJson = await executeRes.json();
            if (!executeRes.ok) {
                throw new Error(`Execution failed: ${JSON.stringify(execJson)}`);
            }

            const data = execJson.data; // TransformInterceptor wraps data
            console.log('Report generated successfully!');
            if (data.grandTotals) {
                console.log('Grand Totals:', data.grandTotals);
            }
            console.log(`Received ${data.lineItems?.length || 0} line items`);

            if (data.lineItems && data.lineItems.length > 0) {
                console.log('Sample Line Item:', JSON.stringify(data.lineItems[0], null, 2));
            }
        } else {
            console.log('No BS schedules found in API.');
        }

    } catch (error) {
        console.error('Error testing API:', error.message);
    }
}

testBalanceSheetApi();
