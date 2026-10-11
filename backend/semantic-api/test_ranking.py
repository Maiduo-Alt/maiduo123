import unittest

from ranking import cosine, rank_candidates


class RankingTest(unittest.TestCase):
    def test_cosine_normalizes_vectors(self):
        self.assertAlmostEqual(cosine([2.0, 0.0], [4.0, 0.0]), 1.0)

    def test_rank_filters_by_threshold_and_sorts(self):
        ranked = rank_candidates(
            [1.0, 0.0],
            [{"id": "close"}, {"id": "far"}, {"id": "middle"}],
            [[0.8, 0.6], [0.0, 1.0], [0.9, 0.1]],
            0.7,
        )
        self.assertEqual([item["id"] for item in ranked], ["middle", "close"])


if __name__ == "__main__":
    unittest.main()
