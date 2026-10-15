export const SAMPLE_FEATURE_NAME = '01_adapter_apitoapi.feature';

export const SAMPLE_FEATURE_CONTENT = `Feature: 01_adapter_apitoapi validation

  # =========================================================
  # TEST DATA DEPENDENCIES
  # This feature is self-contained. No prior feature execution required.
  # It creates the following records used by other features:
  #   - Template  : direct:ApiToApi  (POST /system/adapters/templates/direct:ApiToApi)
  #   - Adapter   : generic.Routeid  (POST /system/adapters/generic.Routeid)
  #
  # INTERNAL DEPENDENCIES (scenario order matters):
  #   Scenario 3 ("To invoke an API internally...") requires Scenario 1 and 2
  #   to have created the template and adapter first.
  # ============================================================

Background:
	Given Set the test backgound
	And MS request header "Content-Type" is set to "application/json"
	And MS request header "Authorization" is set to "jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJqb2IyM2thWTVncyIsImlzcyI6Imh0dHA6Ly8yOSYwxob3N0OjJkMDMvb2F1dGgyL3Rva2VuIiwic3VIjoiMjkwMDA4NjQ3MC1ec_RdeuPkyaug400mG35SweW35OjRqH8jsgoFI4IPLDK-xjc18rZ-ibjv_IrJNv97siCfoUjhLZbG64kIYCJki4eFTaZEZIXMQYhaW2nW-xReuyDDQ7tOaj_9Cg-cOoTjfRprZYqkgqEHx20xOu-i-37xVQUhMj9prLQAZPs7Kvxn-aAsPPLUtd7eYQW30fByq4PMUSM1_524yfXMLzZV-VHHYuMK8pb1xSLdizvn9QcbbDDuvSNPyLpTGhoBbfgZ9_geGjFIky6yjVzw"
	And MS request header "UUID" is set to "adapqi-da5244e-a140-470e-83ad-768cb225640"
	And the MS request body is set to the contents of "src/test/resources/integration-cucumber-json-payload/usecasesjsonpayload/02_apitoapi/apitoapirequestpayload.json"
	When a "POST" request is sent to MS
	And log all MS response in console
	Then MS response code should be 201

Scenario: To create a template configuration persisting to API to API using HTTP POST METHOD
	And MS request URI is "/system/adapters/templates/direct:ApiToApi"
	And MS request header "UUID" is set to "adapqi-da5244e-a140-470e-83ad-768cb225640"
	And the MS request body is set to the contents of "src/test/resources/test/resources/integration-cucumber-json-payload/usecasesjsonpayload/02_apitoapi/apitoapirequestpayload.json"
	When a "POST" request is sent to MS
	And log all MS response in console
	Then MS response code should be 201

Scenario: To create an adapter configuration persisting to API to API using HTTP POST METHOD
	And MS request URI is "/system/adapters/generic.Routeid"
	And MS request header "UUID" is set to "adapqi-da5244e-a140-470e-83ad-768cb225640"
	And the MS request body is set to the contents of "src/test/resources/integration-cucumber-json-payload/usecasesjsonpayload/02_apitoapi/apitoapiadapterconflayoutpayload.json"
	When a "POST" request is sent to MS
	And log all MS response in console
	Then MS response code should be 201

Scenario: To validate Application Context Map while executing API to API use case
	# Then Set the following data criteria
	# | TestCaseID      | ColumnName | Operator | DataType | ColumnValue |
	# | MS-UseCaseTest-Adapter-MS-002| key      | eq | string | c68dba2e-7fdc-46ab-9776-94e90cf3f6d5_invoices |
	# | MS-UseCaseTest-Adapter-MS-002| namespace| eq | string | Codat |
	#
	# And Validate the below details from the db table adapter_context and check no of record is 1
	#
	# | TestCaseID | ColumnName | ColumnValue |
	# | MS-UseCaseTest-Adapter-MS-002| value | 9 |
	#
	# Then Set the following data criteria
	# | TestCaseID | ColumnName | Operator | DataType | ColumnValue |
	# | MS-UseCaseTest-Adapter-MS-002| key      | eq | string | c68dba2e-7fdc-46ab-9776-94e90cf3f6d5_test |
	# | MS-UseCaseTest-Adapter-MS-002| namespace| eq | string | Codat |
	#
	# And Validate the below details from the db table adapter_context and check no of record is 1
	#
	# | TestCaseID | ColumnName | ColumnValue |
	# | MS-UseCaseTest-Adapter-MS-002| value  | 9 |

Scenario: To validate API to API execution by checking status in ms_inbox_events table
	Then Set the following data criteria
	  | TestCaseID                     | ColumnName | Operator | DataType | ColumnValue                                 |
	  | MS-UseCaseTest-Adapter-MS-003 | eventId    | eq       | string   | adapqi-da5244e-a140-470e-83ad-768cb225640   |
	  | MS-UseCaseTest-Adapter-MS-003 | eventType  | eq       | string   | ms-adapterservice.ApiToApi                 |
	
	  And Validate the below details from the db table ms_inbox_events and check no of record is 1
	    | TestCaseID                     | ColumnName | ColumnValue |
	    | MS-UseCaseTest-Adapter-MS-003 | status     | PROCESSED  |

#InvalidInputException
Scenario: To invoke an API internally using an Adapter API HTTP POST METHOD Y
	And MS request URI is "system/apitoapijobs/ApiToApi"
	And MS request header "UUID" is set to "adapqn-da5244e-a140-470e-83ad-768cb225640"
	And the MS request body is set to the contents of "src/test/resources/integration-cucumber-json-payload/usecasesjsonpayload/02_apitoapi/apitoapirequestpayload_negative.json"
	When a "POST" request is sent to MS
	And log all MS response in console
	Then MS response code should be 400

#ExecuteeventAPIFailure
Scenario: To invoke an API internally using an Adapter API HTTP POST METHOD 
	And MS request URI is "system/apitoapijobs/ApiToApi"
	And MS request header "UUID" is set to "adapqn-da5244e-a140-470e-83ad-768cb225640"
	And MS request header "httpEndPoint" is set to "http://dummyip:3000/irf-provider-container/api/v1.0.0/order/paymentOrders/sepaInstantPayment"
	And the MS request body is set to the contents of "src/test/resources/integration-cucumber-json-payload/usecasesjsonpayload/02_apitoapi/apitoapirequestpayload.json"
	When a "POST" request is sent to MS
	And log all MS response in console
	Then MS response code should be 500
`;
