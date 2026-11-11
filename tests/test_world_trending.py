import unittest
from datetime import date

from tools.sync_world_trending import fuse_ranked, matches_record, ranked_records, released


class WorldTrendingTests(unittest.TestCase):
    def test_keeps_rank_and_drops_repeats(self):
        pages = [{"results": [{"id": 2, "name": "B", "first_air_date": "2020-01-01"}, {"id": 1, "title": "A", "release_date": "2021-05-01"}]},
                 {"results": [{"id": 2, "name": "B"}]}]
        self.assertEqual([r["id"] for r in ranked_records(pages)], [2, 1])
        self.assertEqual(ranked_records(pages)[0]["year"], 2020)

    def test_matches_title_only_with_close_year(self):
        record = {"id": 1, "title": "Сверхъестественное", "original": "Supernatural", "year": 2005}
        self.assertTrue(matches_record({"title": "Сверхъестественное", "originalTitle": "Supernatural", "year": 2005}, record))
        self.assertTrue(matches_record({"title": "Другое", "originalTitle": "SUPER-natural", "year": 2006}, record))
        self.assertFalse(matches_record({"title": "Сверхъестественное", "originalTitle": "Supernatural", "year": 2015}, record))
        self.assertFalse(matches_record({"title": "Другое", "originalTitle": "Other", "year": 2005}, record))

    def test_orders_by_real_popularity_number(self):
        pages = [{"results": [{"id": 1, "title": "A", "popularity": 5}, {"id": 2, "title": "B", "popularity": 90}]}]
        self.assertEqual([r["id"] for r in ranked_records(pages)], [2, 1])

    def test_title_high_in_both_rankings_leads(self):
        world = [{"id": "a"}, {"id": "both"}]
        kinopoisk = [{"id": "b"}, {"id": "both"}]
        self.assertEqual(fuse_ranked(world, kinopoisk, 3)[0]["id"], "both")

    def test_country_has_no_effect_on_order(self):
        world = [{"id": "a", "countries": ["США"]}]
        kinopoisk = [{"id": "b", "countries": ["Россия"]}]
        self.assertEqual({c["id"] for c in fuse_ranked(world, kinopoisk, 2)}, {"a", "b"})

    def test_future_premiere_is_not_released(self):
        today = date(2026, 11, 9)
        self.assertTrue(released({"premiere": "2026-11-06"}, today))
        self.assertFalse(released({"premiere": "2026-12-01"}, today))
        self.assertTrue(released({"year": 2020}, today))


if __name__ == "__main__":
    unittest.main()
