Feature: 02_adapter_eventtoapi validation



  # ============================================================

  # TEST DATA DEPENDENCIES

  # This feature is self-contained. No prior feature execution required.

  # It creates the following records used by other features:

  #   - Template  : direct:eventtoapi.json.process

  #                 (POST /system/adapters/templates/direct:eventtoapi.json.process)

  #   - Adapter   : createsepapayment

  #                 (POST /system/adapters/createsepapayment)

  #

  # NOTE: Features 03, 04, 05, 10, 21, 22, 27 also POST to the same

  #   template/adapter IDs (overwriting them). Ensure desired config

  #   is in place before running dependent scenarios.

  #

  # INTERNAL DEPENDENCIES (scenario order matters):

  #   Scenario 3 ("To validate if adapter is able to call an API via Event")

  #   requires Scenario 1 (template) and Scenario 2 (adapter) to exist first.

  #   DB table validated: ms_inbox_events (eventId: 8526cd2c-0d22-11eb-adc1-0242ac120002)

  # ============================================================



Background:

Given Set the test backgound for MICROSERVICE API 

And MS request header "Content-Type" is set to "application/json" 

Given Set the Testcase id MS-UseCaseTest-Adapter-MS-001 for company GB0010001 



Scenario: To create an template configuration pertaining to Event To API using HTTP POST METHOD 

And MS request URI is "/system/adapters/templates/direct:eventtoapi.json.process" 

And MS request header "UUID" is set to "adapz5244e-a140-470e-83ad-768cb225401es00" 

And the MS request body is set to the contents of "src/test/resources/integration-cucumber-json-payload/usecasesjsonpayload/01_eventtoapi/eventtoapitemplateconfigpayload.json" 

When a "POST" request is sent to MS 

And log all MS response in console 

Then MS response code should be 201


Scenario: To create an adapter configuration pertaining to Event to API using HTTP POST METHOD 

And MS request URI is "/system/adapters/createsepapayment" 

And MS request header "UUID" is set to "adapz5244e-a140-470e-83ad-768cb225502es01" 

And the MS request body is set to the contents of "src/test/resources/integration-cucumber-json-payload/usecasesjsonpayload/01_eventtoapi/eventtoapiadapterconfigpayload.json" 

When a "POST" request is sent to MS 

And log all MS response in console 

Then MS response code should be 201 


# INTERNAL DEPENDENCY: Requires "Scenario: To create an template configuration pertaining to Event To API using HTTP POST METHOD" and "Scenario: To create an adapter configuration pertaining to Event to API using HTTP POST METHOD" in this file to have run first.

Scenario: To validate if adapter is able to call an API via Event

When Send Data to Topic ms-adapterservice-event-topic from file integration-cucumber-json-payload/usecasesjsonpayload/01_eventtoapi/eventtoapieventpayload.json for Application MICROSERVICE 


# To validate msadapterservice.ms_inbox_events

Then Set the following data criteria 

| TestCaseID                      | ColumnName | Operator | DataType | ColumnValue |

| MS-UseCaseTest-Adapter-MS-001   | eventId    | eq       | string   | 8526cd2c-0d22-11eb-adc1-0242ac120002 |

| MS-UseCaseTest-Adapter-MS-001   | eventType    | eq       | string   | createsepapayment |

| MS-UseCaseTest-Adapter-MS-001   | status    | eq       | string   | PROCESSED |


And Validate the below details from the db table ms_inbox_events and check no of record is 1

  | TestCaseID                      | ColumnName | ColumnValue |

| MS-UseCaseTest-Adapter-MS-001       | status     | PROCESSED |