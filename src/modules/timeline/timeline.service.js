
const mergeTimeline = (calendarActivities = [], driveActivities = []) => {
    const normalizedDrive = driveActivities.map(activity => {
        if(!activity.endTime) {
            const startTime = new Date(activity.startTime);
            const endTime = new Date(startTime.getTime() + 15 * 60000);
            return { ...activity,
                endTime: endTime.toISOString()
            };
        }
        return activity;
    }) ;

    const allActivities = [...calendarActivities, ...normalizedDrive];

    return allActivities.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
}

const groupByApp = (activities = []) => {
    const grouped = {
        Meet: [],
        Docs: [],
        Sheets: [],
        Drive: [],
        Calendar: []
    };

    activities.forEach(activity => {
        const source = (activity.source || '').toLowerCase();
        const metadata = activity.metadata_json || {};
        const link = (metadata.link || '').toLowerCase();
        const mimeType = (metadata.mimeType || '').toLowerCase();
        const title = (activity.title || '').toLowerCase();



    if (source === 'calendar') {
        if (link.includes('meet.google.com')||title.includes('meet')) {
            grouped.Meet.push(activity);

        } else {
            grouped.Calendar.push(activity);
        }
    }
    else if (source === 'drive') {
        if (mimeType.includes('document') || link.includes('docs.google.com')) {
            grouped.Docs.push(activity);
        } else if (mimeType.includes('spreadsheet') || link.includes('sheets.google.com')) {
            grouped.Sheets.push(activity);
        } else {
            grouped.Drive.push(activity);
        }
    }
    });

    return grouped;
}

module.exports = {
    mergeTimeline,
    groupByApp
}