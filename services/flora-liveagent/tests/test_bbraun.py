import unittest
from unittest.mock import patch

from app import main
from app.bbraun import PUMPS, fields


class PumpTests(unittest.TestCase):
    def values(self, minute):
        return {param: value for _, param, value, _ in fields(PUMPS[0], minute)}

    def test_volume_balance_pause_resume_and_completion(self):
        running, paused, resumed, complete = [self.values(m) for m in (20, 35, 45, 300)]
        self.assertEqual(running['infused_volume'], 4)
        self.assertEqual(paused['infused_volume'], self.values(30)['infused_volume'])
        self.assertEqual(paused['infusion_rate'], 0)
        self.assertEqual(paused['active_pumping'], 0)
        self.assertEqual(resumed['infused_volume'], 7)
        self.assertEqual(resumed['infusion_rate'], 12)
        self.assertEqual(complete['vtbi'], 0)
        self.assertEqual(complete['infused_volume'], 50)
        self.assertEqual(complete['infusion_rate'], 0)
        self.assertEqual(complete['end_of_volume_alarm'], 1)
        for minute in range(400):
            values = self.values(minute)
            self.assertAlmostEqual(values['vtbi'] + values['infused_volume'], 50)

    def test_profiles_identity_and_original_code(self):
        start = 1_800_000_000_000
        with patch.object(main, 'PUMP_START_MS', start):
            with patch.object(main, 'PROFILE', 'bbraun'):
                self.assertEqual(main.observations_for_minute(start - 60_000), [])
                rows = main.observations_for_minute(start)
                self.assertEqual(rows, main.observations_for_minute(start))
                self.assertEqual({r['device_id'] for r in rows}, {p['device_id'] for p in PUMPS})
                self.assertTrue(all(r['synthetic'] and r['source'] == 'liveagent' for r in rows))
                rates = [r for r in rows if r['ivy_param'] == 'infusion_rate']
                self.assertEqual([r['value'] for r in rates], [12, 24])
                self.assertTrue(all(r['unit'] == 'mL/h' and r['raw_code'] == 'BCC_INRT' for r in rates))
                bulk = main.observations_bulk(start, start + 60_000, 60)
                self.assertEqual(bulk[str(start)], rows)
                self.assertEqual(main.observations(start, start + 60_000), rows)
                status = main.device_status(30)
                self.assertEqual(status['summary']['total_devices'], 2)
                self.assertEqual(len({d['id'] for d in status['logical_devices']}), 2)
                self.assertTrue(all(d['category'] == 'infusion_pump' for d in status['devices']))
            with patch.object(main, 'PROFILE', 'stable-anes-bbraun'):
                rows = main.observations_for_minute(start)
                self.assertEqual(len({r['device_id'] for r in rows}), 4)
            with patch.object(main, 'PROFILE', 'stable-anes'):
                self.assertEqual(len({r['device_id'] for r in main.observations_for_minute(start)}), 2)
