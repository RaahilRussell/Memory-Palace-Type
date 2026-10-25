import unittest
from pose_candidates import proposals, observation_score


class PoseCandidateTests(unittest.TestCase):
    def test_each_person_precedes_generic_searches(self):
        boxes = [[.1, .05, .9, .3], [.3, .4, .8, .6], [.1, .7, .6, .95]]
        crops = list(proposals(1000, 800, boxes, [], limit=4))
        self.assertEqual(len(crops), 4)
        for crop, box in zip(crops[1:], boxes):
            top, left, bottom, right = box
            self.assertLessEqual(crop[0], left * 1000)
            self.assertGreaterEqual(crop[2], right * 1000)
            self.assertLessEqual(crop[1], top * 800)
            self.assertGreaterEqual(crop[3], bottom * 800)

    def test_boxes_are_bounded_deduplicated_and_budgeted(self):
        crops = list(proposals(300, 200, [[0, 0, 1, 1], [float('nan'), 0, 1, 1], [1, 0, 0, 1]] * 20,
                               [[0, 0, 30, 30]] * 30, limit=8))
        self.assertEqual(len(crops), len(set(crops)))
        self.assertLessEqual(len(crops), 8)
        self.assertTrue(all(0 <= l < r <= 300 and 0 <= t < b <= 200 for l, t, r, b in crops))

    def test_cropped_seated_upper_body_survives_hidden_hips(self):
        confidence = [.1] * 33
        for i in [0, 11, 12, 13, 15]:
            confidence[i] = .9
        self.assertIsNotNone(observation_score(confidence))
        self.assertEqual(confidence[23], .1)
        self.assertEqual(confidence[24], .1)

    def test_face_only_or_unreliable_body_is_not_a_pose(self):
        confidence = [.1] * 33
        confidence[0] = .99
        self.assertIsNone(observation_score(confidence))
        self.assertIsNone(observation_score([float('nan')] * 33))


if __name__ == '__main__':
    unittest.main()
