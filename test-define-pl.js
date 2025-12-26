const axios = require('axios');

async function testDefinePL() {
    const API_URL = 'http://127.0.0.1:3001/api/v1';

    try {
        console.log('--- Testing P&L Definition Flow ---');

        // 1. Fetch all PL schedules
        console.log('Fetching PL schedules...');
        const res = await fetch(`${API_URL}/report/schedule?type=PL`);
        const json = await res.json();

        if (!res.ok) {
            throw new Error(`Failed to fetch schedules: ${JSON.stringify(json)}`);
        }

        const schedules = json.data;
        console.log(`Found ${schedules.length} PL schedules.`);

        if (schedules.length > 0) {
            for (const s of schedules) {
                console.log(`\nSchedule: ${s.schedule_name} (ID: ${s.id})`);
                // The execute endpoint is what we tested before, but here we just want to ensure the definition works.
                // Let's check if we can fetch the specific schedule details if there was an endpoint for it.
                // The getAllReportSchedules doesn't seem to return details in the header list.
            }
        } else {
            console.log('No PL schedules found. This means the Define P&L page has no data to show in reports.');
        }

        // 2. Check if we can create a new schedule (Test the POST /report/schedule)
        console.log('\nTesting schedule creation...');
        const testSchedule = {
            schedule_name: 'Auto-Test P&L ' + Date.now(),
            template_name: 'Test Template',
            report_type: 'PL',
            details: [
                { particulars: 'Test Income', code_from: 'I999', code_to: 'I1000' }
            ]
        };

        const createRes = await fetch(`${API_URL}/report/schedule`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testSchedule)
        });

        const createJson = await createRes.json();
        if (createRes.ok) {
            console.log('Schedule created successfully!', createJson.data);
        } else {
            console.error('Failed to create schedule:', createJson);
        }

    } catch (error) {
        console.error('Test failed:', error.message);
    }
}

testDefinePL();
