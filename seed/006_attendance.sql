INSERT INTO event_attendance (id, occurrence_id, participant_id, status, recorded_by_person_id, created_at, updated_at)
WITH next_practice(occurrence_id) AS (
  SELECT id
  FROM event_occurrences
  WHERE series_id = 'event_series_seed_falcons_practice' AND local_date > date('now', '-7 hours')
  ORDER BY local_date
  LIMIT 1
),
rsvps(event_key, occurrence_id, participant_key, participant_id, status, recorded_by_person_id) AS (
  SELECT 'practice', occurrence_id, 'avery', 'participant_seed_avery', 'yes', 'person_seed_parent' FROM next_practice
  UNION ALL
  SELECT 'practice', occurrence_id, 'blake', 'participant_seed_blake', 'maybe', 'person_seed_parent' FROM next_practice
  UNION ALL
  SELECT 'hawks', 'event_occurrence_seed_falcons_hawks', 'avery', 'participant_seed_avery', 'no', 'person_seed_parent'
  UNION ALL
  SELECT 'hawks', 'event_occurrence_seed_falcons_hawks', 'blake', 'participant_seed_blake', 'yes', 'person_seed_parent'
  UNION ALL
  SELECT 'clinic', 'event_occurrence_seed_comets_clinic', 'quinn', 'participant_seed_quinn', 'yes', 'person_seed_second_team_guardian'
)
SELECT
  'attendance_seed_' || event_key || '_' || participant_key,
  occurrence_id,
  participant_id,
  status,
  recorded_by_person_id,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM rsvps;
