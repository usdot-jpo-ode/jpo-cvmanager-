from os import environ
from addons.images.count_metric import driver
from mock import MagicMock
from unittest.mock import patch

@patch("addons.images.count_metric.driver.pgquery.query_db")
def test_get_rsu_data(mock_query_db):
    # mock
    mock_query_db.return_value = [("ipaddr", "proute")]

    # run
    result = driver.get_rsu_data()

    expected_result = [{"ipAddress": "ipaddr", "primaryRoute": "proute"}]
    mock_query_db.assert_called_once()
    assert result == expected_result


def test_populateRsuDict_success():
    # prepare
    rsu_data = [{"ipAddress": "192.168.0.10", "primaryRoute": "I-80"}]

    # call
    driver.populateRsuDict(rsu_data)

    # check that  rsu_location_dict is correct
    rsu_location_dict = driver.rsu_location_dict
    expected_rsu_location_dict = {"192.168.0.10": "I-80"}
    assert rsu_location_dict == expected_rsu_location_dict

    # check that rsu_count_dict is correct
    rsu_count_dict = driver.rsu_count_dict
    expected_rsu_count_dict = {"I-80": {"192.168.0.10": 0}, "Unknown": {}}
    assert rsu_count_dict == expected_rsu_count_dict


def test_populateRsuDict_empty_object():
    # prepare
    rsu_data = []

    driver.rsu_location_dict = {}
    driver.rsu_count_dict = {}

    driver.populateRsuDict(rsu_data)

    assert driver.rsu_location_dict == {}
    assert driver.rsu_count_dict == {"Unknown": {}}


def test_run_success():
    # prepare
    driver.rsu_location_dict = {}
    driver.rsu_count_dict = {}
    driver.populateRsuDict = MagicMock()
    driver.get_rsu_data = MagicMock(return_value="rsuJson")
    driver.KafkaMessageCounter = MagicMock()
    driver.KafkaMessageCounter.return_value = MagicMock()
    driver.KafkaMessageCounter.return_value.run = MagicMock()
    environ["MESSAGE_TYPES"] = "bsm"

    # call
    driver.run()

    # check
    driver.populateRsuDict.assert_called_with("rsuJson")
    driver.KafkaMessageCounter.assert_called()


def test_run_message_types_not_set():
    # prepare
    environ["MESSAGE_TYPES"] = ""
    driver.rsu_location_dict = {}
    driver.rsu_count_dict = {}
    driver.logging = MagicMock()
    driver.logging.error = MagicMock()
    driver.exit = MagicMock()
    driver.exit.side_effect = SystemExit

    # call
    try:
        driver.run()
    except SystemExit:
        pass

    # check
    driver.logging.error.assert_called_once_with(
        "MESSAGE_TYPES environment variable not set! Exiting."
    )
    driver.exit.assert_called_once_with(
        "MESSAGE_TYPES environment variable not set! Exiting."
    )
