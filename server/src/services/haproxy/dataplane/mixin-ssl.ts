import FormData from 'form-data';
import { loadbalancerLogger } from '../../../lib/logger-factory';
import { HAProxyBaseConstructor } from './types';

const logger = loadbalancerLogger();

export function SSLMixin<TBase extends HAProxyBaseConstructor>(Base: TBase) {
  return class extends Base {
    /**
     * Upload a new SSL certificate to HAProxy storage
     *
     * @param filename - Certificate filename (e.g., "example.com.pem")
     * @param certificatePem - Combined PEM content (certificate + private key)
     * @param forceReload - Whether to force HAProxy reload (default: false, uses Runtime API)
     * @returns Success indicator
     */
    async uploadSSLCertificate(
      filename: string,
      certificatePem: string,
      forceReload: boolean = false
    ): Promise<void> {
      try {
        logger.info({ filename, forceReload }, 'Uploading SSL certificate via DataPlane API');

        // Create FormData for multipart/form-data upload
        const formData = new FormData();
        formData.append('file_upload', Buffer.from(certificatePem), {
          filename: filename,
          contentType: 'application/x-pem-file'
        });

        // POST to storage/ssl_certificates endpoint
        await this.httpClient.post(
          `/services/haproxy/storage/ssl_certificates?force_reload=${forceReload}`,
          formData
        );

        logger.info({ filename }, 'SSL certificate uploaded successfully');
      } catch (error) {
        this.handleApiError(error, 'upload SSL certificate', { filename });
        throw error;
      }
    }

    /**
     * Update an existing SSL certificate in HAProxy storage
     *
     * @param filename - Certificate filename (e.g., "example.com.pem")
     * @param certificatePem - Combined PEM content (certificate + private key)
     * @param forceReload - Whether to force HAProxy reload (default: false, uses Runtime API)
     * @returns Success indicator
     */
    async updateSSLCertificate(
      filename: string,
      certificatePem: string,
      forceReload: boolean = false
    ): Promise<void> {
      try {
        logger.info({ filename, forceReload }, 'Updating SSL certificate via DataPlane API');

        // PUT to storage/ssl_certificates/{filename} endpoint with raw PEM content
        await this.httpClient.put(
          `/services/haproxy/storage/ssl_certificates/${filename}?force_reload=${forceReload}`,
          certificatePem,
          {
            headers: {
              'Content-Type': 'text/plain'
            }
          }
        );

        logger.info({ filename }, 'SSL certificate updated successfully');
      } catch (error) {
        this.handleApiError(error, 'update SSL certificate', { filename });
        throw error;
      }
    }

    /**
     * Delete an SSL certificate from HAProxy storage
     *
     * @param filename - Certificate filename (e.g., "example.com.pem")
     * @param forceReload - Whether to force HAProxy reload (default: false for deletions)
     * @returns Success indicator
     */
    async deleteSSLCertificate(
      filename: string,
      forceReload: boolean = false
    ): Promise<void> {
      try {
        logger.info({ filename, forceReload }, 'Deleting SSL certificate via DataPlane API');

        // DELETE storage/ssl_certificates/{filename} endpoint
        await this.httpClient.delete(
          `/services/haproxy/storage/ssl_certificates/${filename}?force_reload=${forceReload}`
        );

        logger.info({ filename }, 'SSL certificate deleted successfully');
      } catch (error) {
        // If certificate doesn't exist, log warning but don't throw
        if ((error as { response?: { status?: number } }).response?.status === 404) {
          logger.warn(
            { filename },
            'SSL certificate not found during deletion, may have been already removed'
          );
          return;
        }
        this.handleApiError(error, 'delete SSL certificate', { filename });
        throw error;
      }
    }

    /**
     * List all SSL certificates in HAProxy storage
     *
     * @returns Array of certificate filenames
     */
    async listSSLCertificates(): Promise<string[]> {
      try {
        logger.debug('Listing SSL certificates via DataPlane API');

        const response = await this.httpClient.get(
          `/services/haproxy/storage/ssl_certificates`
        );

        const certificates = response.data?.data || [];
        logger.debug({ count: certificates.length }, 'SSL certificates listed');

        return certificates;
      } catch (error) {
        this.handleApiError(error, 'list SSL certificates', {});
        return [];
      }
    }
  };
}
