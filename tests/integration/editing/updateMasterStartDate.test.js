/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { getParserManager } from '../../../src/index.js'
import DurationValue from '../../../src/values/durationValue.js'

jest.mock('../../../src/factories/dateFactory.js')

/**
 * Parse a calendar and return its recurring master item.
 *
 * @param {string} ics iCalendar data
 * @return {AbstractRecurringComponent}
 */
function getMasterItem(ics) {
	const parser = getParserManager().getParserForFileType('text/calendar')
	parser.parse(ics)
	const calendarComponent = parser.getItemIterator().next().value

	return Array.from(calendarComponent.getComponentIterator())
		.find(component => component.name === 'VEVENT' && !component.hasProperty('RECURRENCE-ID'))
}

/**
 * Build a minimal recurring calendar from VEVENT property arrays.
 *
 * @param {string[]} masterProperties Properties of the master VEVENT
 * @param {string[][]} exceptionProperties Properties of exception VEVENTs
 * @return {string}
 */
function buildCalendar(masterProperties, exceptionProperties = []) {
	const event = properties => ['BEGIN:VEVENT', 'UID:update-start-test', ...properties, 'END:VEVENT']

	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Nextcloud Tests//calendar-js//EN',
		...event(masterProperties),
		...exceptionProperties.flatMap(event),
		'END:VCALENDAR',
	].join('\r\n')
}

/**
 * Shift a master item by a number of seconds through its public setter.
 *
 * @param {AbstractRecurringComponent} masterItem Master event
 * @param {number} seconds Number of seconds to shift
 */
function shiftMaster(masterItem, seconds) {
	const shiftedStart = masterItem.startDate.clone()
	shiftedStart.addDuration(DurationValue.fromSeconds(seconds))
	masterItem.startDate = shiftedStart
}

const asICALString = value => value.toICALJs().toString()

describe('updateStartDateOfMasterItem', () => {
	it('shifts an existing recurrence exception once without hanging', () => {
		const masterItem = getMasterItem(getAsset('weekly-recurring-with-exception'))
		const recurrenceManager = masterItem.recurrenceManager
		const originalExceptionRecurrenceId = recurrenceManager.getRecurrenceExceptionList()[0].recurrenceId.clone()

		shiftMaster(masterItem, 24 * 60 * 60)

		const exceptionsAfter = recurrenceManager.getRecurrenceExceptionList()
		expect(exceptionsAfter).toHaveLength(1)

		const expectedShiftedRecurrenceId = originalExceptionRecurrenceId.clone()
		expectedShiftedRecurrenceId.addDuration(DurationValue.fromSeconds(24 * 60 * 60))
		expect(exceptionsAfter[0].recurrenceId.compare(expectedShiftedRecurrenceId)).toEqual(0)
	})

	it('preserves every exception when adjacent recurrence IDs shift onto occupied map keys', () => {
		const masterItem = getMasterItem(buildCalendar(
			['DTSTART:20240101T090000Z', 'RRULE:FREQ=DAILY;COUNT=10'],
			[
				['DTSTART:20240102T100000Z', 'RECURRENCE-ID:20240102T090000Z'],
				['DTSTART:20240103T100000Z', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20240103T090000Z'],
				['DTSTART:20240104T100000Z', 'RECURRENCE-ID:20240104T090000Z'],
			],
		))
		const recurrenceManager = masterItem.recurrenceManager

		shiftMaster(masterItem, 24 * 60 * 60)

		expect(recurrenceManager.getRecurrenceExceptionList()
			.map(exception => asICALString(exception.recurrenceId))
			.sort()).toEqual([
			'2024-01-03T09:00:00Z',
			'2024-01-04T09:00:00Z',
			'2024-01-05T09:00:00Z',
		])
		const rangeException = recurrenceManager.getRecurrenceExceptionList()
			.find(exception => exception.modifiesFuture())
		expect(recurrenceManager.getRangeRecurrenceExceptionForId(
			recurrenceManager.getRecurrenceExceptionList().at(-1).recurrenceId,
		)).toEqual(rangeException)
	})

	it.each([
		['forward across a month boundary', 36 * 60 * 60, '2024-02-02T21:00:00Z'],
		['backward across a month boundary', -12 * 60 * 60, '2024-01-31T21:00:00Z'],
		['by a zero-length duration', 0, '2024-02-01T09:00:00Z'],
	])('shifts recurrence IDs %s', (_scenario, seconds, expectedRecurrenceId) => {
		const masterItem = getMasterItem(buildCalendar(
			['DTSTART:20240131T090000Z', 'RRULE:FREQ=DAILY;COUNT=5'],
			[['DTSTART:20240201T100000Z', 'RECURRENCE-ID:20240201T090000Z']],
		))

		shiftMaster(masterItem, seconds)

		expect(asICALString(masterItem.recurrenceManager.getRecurrenceExceptionList()[0].recurrenceId))
			.toEqual(expectedRecurrenceId)
	})

	it('shifts EXDATE values except those that also match an unchanged RDATE', () => {
		const masterItem = getMasterItem(buildCalendar([
			'DTSTART:20240101T090000Z',
			'RRULE:FREQ=DAILY;COUNT=10',
			'RDATE:20240105T090000Z',
			'EXDATE:20240103T090000Z,20240105T090000Z',
		]))

		shiftMaster(masterItem, 24 * 60 * 60)

		expect(masterItem.recurrenceManager.listAllRecurrenceDates(false).map(asICALString))
			.toEqual(['2024-01-05T09:00:00Z'])
		expect(masterItem.recurrenceManager.listAllRecurrenceDates(true).map(asICALString).sort())
			.toEqual(['2024-01-04T09:00:00Z', '2024-01-05T09:00:00Z'])
	})

	it('leaves an RDATE-based exception unchanged while shifting a rule-based exception', () => {
		const masterItem = getMasterItem(buildCalendar(
			['DTSTART:20240101T090000Z', 'RRULE:FREQ=DAILY;COUNT=10', 'RDATE:20240110T090000Z'],
			[
				['DTSTART:20240103T100000Z', 'RECURRENCE-ID:20240103T090000Z'],
				['DTSTART:20240110T100000Z', 'RECURRENCE-ID:20240110T090000Z'],
			],
		))

		shiftMaster(masterItem, 24 * 60 * 60)

		expect(masterItem.recurrenceManager.getRecurrenceExceptionList()
			.map(exception => asICALString(exception.recurrenceId))
			.sort()).toEqual(['2024-01-04T09:00:00Z', '2024-01-10T09:00:00Z'])
	})

	it('shifts RRULE UNTIL while leaving a COUNT-based rule unchanged', () => {
		const untilMaster = getMasterItem(buildCalendar([
			'DTSTART:20240101T090000Z',
			'RRULE:FREQ=DAILY;UNTIL=20240131T090000Z',
		]))
		const countMaster = getMasterItem(buildCalendar([
			'DTSTART:20240101T090000Z',
			'RRULE:FREQ=DAILY;COUNT=10',
		]))

		shiftMaster(untilMaster, 2 * 24 * 60 * 60)
		shiftMaster(countMaster, 2 * 24 * 60 * 60)

		const untilRule = untilMaster.recurrenceManager.getRecurrenceRuleList()[0]
		const countRule = countMaster.recurrenceManager.getRecurrenceRuleList()[0]
		expect(asICALString(untilRule.until)).toEqual('2024-02-02T09:00:00Z')
		expect(countRule.until).toBeNull()
		expect(countRule.count).toEqual(10)
	})

	it('shifts all-day recurrence metadata by whole days', () => {
		const masterItem = getMasterItem(buildCalendar(
			[
				'DTSTART;VALUE=DATE:20240228',
				'RRULE:FREQ=DAILY;UNTIL=20240305',
				'EXDATE;VALUE=DATE:20240301',
			],
			[['DTSTART;VALUE=DATE:20240303', 'RECURRENCE-ID;VALUE=DATE:20240302']],
		))

		shiftMaster(masterItem, 2 * 24 * 60 * 60)

		expect(asICALString(masterItem.recurrenceManager.listAllRecurrenceDates(true)[0]))
			.toEqual('2024-03-03')
		expect(asICALString(masterItem.recurrenceManager.getRecurrenceExceptionList()[0].recurrenceId))
			.toEqual('2024-03-04')
		expect(asICALString(masterItem.recurrenceManager.getRecurrenceRuleList()[0].until))
			.toEqual('2024-03-07')
	})
})
