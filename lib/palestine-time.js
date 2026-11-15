const timeZone = 'Asia/Hebron';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function formattedParts(value) {
  return Object.fromEntries(formatter.formatToParts(new Date(value))
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
}

export function palestineMonthKey(value = new Date()) {
  const parts = formattedParts(value);
  return `${parts.year}-${parts.month}`;
}

export function palestineLocalToUtc(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new RangeError('Expected a local date and time');
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  if (Number(yearText) < 2000 || Number(yearText) > 2100) {
    throw new RangeError('Unsupported year');
  }
  const localWallTime = Date.UTC(
    Number(yearText), Number(monthText) - 1, Number(dayText), Number(hourText), Number(minuteText),
  );
  let candidate = localWallTime;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = formattedParts(candidate);
    const representedWallTime = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    const difference = localWallTime - representedWallTime;
    if (difference === 0) break;
    candidate += difference;
  }

  const result = new Date(candidate).toISOString();
  if (palestineLocalFromUtc(result) !== value) throw new RangeError('Invalid local time in Palestine');
  return result;
}

export function palestineLocalFromUtc(value) {
  const parts = formattedParts(value);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function palestineMonthBounds(month) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new RangeError('Invalid month');
  }
  const [year, monthNumber] = month.split('-').map(Number);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  const nextMonthKey = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
  return {
    start: palestineLocalToUtc(`${month}-01T00:00`),
    end: palestineLocalToUtc(`${nextMonthKey}-01T00:00`),
  };
}
